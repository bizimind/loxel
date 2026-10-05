/**
 * Maps ActionId -> imperative side effects via existing custom events and store actions.
 */

import type { IDockviewPanel } from "dockview-react";
import { useCallback } from "react";

import type { SplitPosition } from "@/components/dockview/default-layout";
import { getFocusedFindTarget } from "@/lib/find-targets";
import {
  moveFocus,
  toggleFocusedArea,
  toggleSidebarPanel,
  toggleWorktreeSidebar,
} from "@/lib/focus-navigation";
import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { navigateToNotification } from "@/lib/notification-navigation";
import { getActiveEditorFilePath } from "@/lib/reveal-in-explorer";
import { useCommandPaletteStore } from "@/store/command-palette";
import { useFileSearchStore } from "@/store/file-search";
import type { ActionId, SplitDirection, SplitPanelType } from "@/store/keybindings/action-registry";
import type { MoveDirection } from "@/store/layout-actions";
import { activatePanel, findAdjacentCenterGroup } from "@/store/layout-actions";
import {
  getCenterPanelDef,
  getCenterPanelDefByType,
  getCreateEventForAction,
} from "@/store/panel-config";
import { usePanelNotificationStore } from "@/store/panel-notifications";
import { deriveProject, useProjectStore } from "@/store/projects";
import { useSearchStore } from "@/store/search";
import { useSettingsStore } from "@/store/settings-store";
import { getCenterApi, showPanel } from "@/store/tools-bar";
import { goBackWorktree, goForwardWorktree } from "@/store/worktree-history";
import { getOrderedWorktrees, useWorktreeStore } from "@/store/worktrees";

type SplitActionId = Extract<ActionId, `panel.split.${string}`>;

function isSplitAction(actionId: ActionId): actionId is SplitActionId {
  return actionId.startsWith("panel.split.");
}

const SPLIT_POSITION_DIRECTION = {
  right: "right",
  left: "left",
  up: "above",
  down: "below",
} as const satisfies Record<SplitDirection, SplitPosition["direction"]>;

/**
 * Open a new panel next to the active one, toward `direction` — or as a tab in its group when
 * `direction` is null: of `type` when given, otherwise of the active panel's type (singletons
 * can't be split). Without an active panel, a typed split just opens the panel.
 */
function splitActivePanel(direction: SplitDirection | null, type: SplitPanelType | null): void {
  const api = getCenterApi();
  if (!api) return;
  const active = api.activePanel;
  const def = type ? getCenterPanelDefByType(type) : active && getCenterPanelDef(active.id);
  if (!def || (!type && def.singleton)) return;

  const detail: Record<string, unknown> = {};
  if (active && direction) {
    const split: SplitPosition = {
      referencePanel: active.id,
      direction: SPLIT_POSITION_DIRECTION[direction],
    };
    detail.split = split;
  }
  // For code editors, extract extension from the active editor's file path
  if (!type && active && def.type === "codeEditor") {
    const filePath = active.id.slice(def.idPrefix.length);
    const dot = filePath.lastIndexOf(".");
    const slash = filePath.lastIndexOf("/");
    if (dot > slash) detail.ext = filePath.slice(dot + 1);
  }
  window.dispatchEvent(new CustomEvent(def.createEvent, { detail }));
}

/** `panel.split.<dir>` or `panel.split.<type>.<dir>` → its parts. */
function parseSplitAction(actionId: SplitActionId): {
  direction: SplitDirection;
  type: SplitPanelType | null;
} {
  const parts = actionId.split(".");
  return parts.length === 4
    ? { type: parts[2] as SplitPanelType, direction: parts[3] as SplitDirection }
    : { type: null, direction: parts[2] as SplitDirection };
}

/**
 * Split the active panel off into a new local sub-group (when it has tab
 * siblings) or promote its whole group to the root edge (when it's alone).
 * Shared by the `panel.move.group*` (no-adjacent fallback) and
 * `panel.move.new*` handlers. See the handlers for the full semantics.
 */
function splitOrPromote(active: IDockviewPanel, position: "left" | "right" | "top" | "bottom") {
  if (active.group.panels.length > 1) {
    active.api.moveTo({ group: active.group, position });
  } else {
    active.group.api.moveTo({ position });
  }
}

/**
 * Resolve the active project + its worktree state, or null when no project is active.
 * Works for bare and regular repos alike: a regular repo's root is not a managed worktree, so
 * the per-action guards below skip it naturally.
 */
function getActiveProjectWorktrees() {
  const wtState = useWorktreeStore.getState();
  const projects = useProjectStore.getState().projects;
  const project = deriveProject(wtState.activeWorktreePath, projects);
  if (!project) return null;
  const ps = wtState.byProject[project.path];
  return { wtState, project, ps };
}

/**
 * Returns a stable dispatch function that executes actions by ID.
 * Uses the center dockview API (via getCenterApi()) for panel operations.
 */
export function useActionHandler(): (actionId: ActionId) => void {
  return useCallback((actionId: ActionId) => {
    // Check for panel creation actions derived from CENTER_PANELS registry
    const createEvent = getCreateEventForAction(actionId);
    if (createEvent) {
      window.dispatchEvent(new Event(createEvent));
      return;
    }

    // -- Panel splitting (new panel of the active panel's type, or of a given type) --
    if (isSplitAction(actionId)) {
      const { direction, type } = parseSplitAction(actionId);
      splitActivePanel(direction, type);
      return;
    }

    switch (actionId) {
      // -- New tab of the active panel's type, in its group --
      case "panel.newTab":
        splitActivePanel(null, null);
        break;

      // -- Panel close --
      case "panel.close": {
        const active = getCenterApi()?.activePanel;
        if (active) active.api.close();
        break;
      }

      // -- Panel navigation --
      case "panel.next":
      case "panel.prev": {
        const api = getCenterApi();
        if (!api) break;
        const allPanels = api.panels;
        if (allPanels.length === 0) break;
        const activeIdx = allPanels.findIndex((p) => p.api.isActive);
        const dir = actionId === "panel.next" ? 1 : -1;
        const nextIdx = (activeIdx + dir + allPanels.length) % allPanels.length;
        const next = allPanels[nextIdx];
        if (next) activatePanel(api, next);
        break;
      }

      // -- Focus panel by position (1-9) --
      case "panel.focus.1":
      case "panel.focus.2":
      case "panel.focus.3":
      case "panel.focus.4":
      case "panel.focus.5":
      case "panel.focus.6":
      case "panel.focus.7":
      case "panel.focus.8":
      case "panel.focus.9": {
        const api = getCenterApi();
        if (!api) break;
        const idx = Number(actionId.split(".").pop()) - 1;
        const target = api.panels[idx];
        if (target) activatePanel(api, target);
        break;
      }

      // -- Panel move to existing group (fallback: new split) --
      case "panel.move.groupRight":
      case "panel.move.groupLeft":
      case "panel.move.groupUp":
      case "panel.move.groupDown": {
        const api = getCenterApi();
        if (!api) break;
        const active = api.activePanel;
        if (!active) break;

        const dirMap = {
          "panel.move.groupRight": "right",
          "panel.move.groupLeft": "left",
          "panel.move.groupUp": "up",
          "panel.move.groupDown": "down",
        } as const;
        const direction = dirMap[actionId];
        const posMap = { right: "right", left: "left", up: "top", down: "bottom" } as const;
        const position = posMap[direction];

        const adjacent = findAdjacentCenterGroup(api, active.group, direction);
        if (adjacent) {
          active.api.moveTo({ group: adjacent, position: "center" });
        } else {
          splitOrPromote(active, position);
        }
        requestAnimationFrame(() => activatePanel(api, active));
        break;
      }

      // -- Directional focus navigation (center, side tool bars, worktree sidebar) --
      case "panel.focus.right":
      case "panel.focus.left":
      case "panel.focus.up":
      case "panel.focus.down":
        moveFocus(actionId.slice("panel.focus.".length) as MoveDirection);
        break;

      // -- Panel move to new split (always creates new group) --
      case "panel.move.newRight":
      case "panel.move.newLeft":
      case "panel.move.newUp":
      case "panel.move.newDown": {
        const api = getCenterApi();
        if (!api) break;
        const active = api.activePanel;
        if (!active) break;

        const posMap = {
          "panel.move.newRight": "right",
          "panel.move.newLeft": "left",
          "panel.move.newUp": "top",
          "panel.move.newDown": "bottom",
        } as const;
        splitOrPromote(active, posMap[actionId]);
        requestAnimationFrame(() => activatePanel(api, active));
        break;
      }

      // -- Sidebar panel toggles --
      case "toggle.projectFiles":
        toggleSidebarPanel("projectFiles");
        break;
      case "toggle.changes":
        toggleSidebarPanel("changes");
        break;
      case "toggle.git":
        toggleSidebarPanel("git");
        break;
      case "toggle.comments":
        toggleSidebarPanel("comments");
        break;
      case "toggle.logs":
        toggleSidebarPanel("logs");
        break;
      case "toggle.forkTree":
        toggleSidebarPanel("forkTree");
        break;

      // -- Worktree sidebar expand/collapse --
      case "sidebar.worktree.toggle":
        toggleWorktreeSidebar();
        break;
      case "sidebar.toggleFocused":
        toggleFocusedArea();
        break;

      // -- Navigation --
      case "nav.search":
        useSearchStore.getState().open();
        break;
      // -- Find in the focused panel --
      case "find.open":
        getFocusedFindTarget()?.open();
        break;
      case "find.next":
        getFocusedFindTarget()?.next();
        break;
      case "find.previous":
        getFocusedFindTarget()?.previous();
        break;

      case "nav.openFile":
        useFileSearchStore.getState().open();
        break;
      case "nav.recentNotification": {
        const recent = usePanelNotificationStore.getState().notifications[0];
        if (recent) navigateToNotification(recent);
        break;
      }

      case "file.revealInExplorer": {
        const filePath = getActiveEditorFilePath();
        if (filePath) {
          // The event (not `revealInProjectExplorer`) also reveals Others files and drafts, which
          // the pending reveal can't, as they are outside every folder tree.
          showPanel("projectFiles");
          dispatchLoxelEvent("loxel-reveal-in-explorer", { filePath });
        }
        break;
      }

      case "nav.commandPalette":
        useCommandPaletteStore.getState().open();
        break;

      // Placeholders for future picker UI
      case "nav.project":
      case "nav.worktree":
        break;

      // -- Worktree history (global across projects) --
      case "worktree.back":
        goBackWorktree();
        break;
      case "worktree.forward":
        goForwardWorktree();
        break;

      // -- Worktree focus by index --
      case "worktree.focus.0":
      case "worktree.focus.1":
      case "worktree.focus.2":
      case "worktree.focus.3":
      case "worktree.focus.4":
      case "worktree.focus.5":
      case "worktree.focus.6":
      case "worktree.focus.7":
      case "worktree.focus.8":
      case "worktree.focus.9": {
        const ctx = getActiveProjectWorktrees();
        if (!ctx?.ps) break;
        // Numbering skips hidden worktrees whether or not the sidebar is expanded, so a digit
        // always means the same worktree (the collapsed rail's order).
        const hidden = new Set(ctx.ps.hiddenPaths);
        const ordered = getOrderedWorktrees(ctx.ps.worktrees, ctx.ps.customOrder).filter(
          (wt) => !wt.pending && !hidden.has(wt.path),
        );
        if (ordered.length === 0) break;

        const digit = Number(actionId.split(".")[2]);
        // 1-8 = positions 1-8, 9 = always last worktree (like Cmd+9 in browsers),
        // 0 = position 10. Note: position 9 (index 8) is unreachable by design —
        // this matches the standard tab-switching convention.
        const idx = digit === 9 ? ordered.length - 1 : digit === 0 ? 9 : digit - 1;
        if (ordered[idx]) ctx.wtState.switchWorktree(ordered[idx].path);
        break;
      }

      // -- Worktree create --
      case "worktree.new": {
        const ctx = getActiveProjectWorktrees();
        if (!ctx) break;

        // Expand sidebar + project if needed
        const projState = useProjectStore.getState();
        if (!projState.sidebarExpanded) projState.toggleSidebar();
        if (!projState.expandedProjectIds.includes(ctx.project.id)) {
          projState.toggleProjectExpanded(ctx.project.id);
        }

        ctx.wtState.requestCreateWorktree();
        break;
      }

      // -- Worktree delete --
      case "worktree.delete": {
        const ctx = getActiveProjectWorktrees();
        if (!ctx?.ps) break;

        const wt = ctx.ps.worktrees.find((w) => w.path === ctx.wtState.activeWorktreePath);
        if (!wt || wt.pending || wt.isMain) break;

        // Expand sidebar + project so confirmation dialogs are visible
        const projState = useProjectStore.getState();
        if (!projState.sidebarExpanded) projState.toggleSidebar();
        if (!projState.expandedProjectIds.includes(ctx.project.id)) {
          projState.toggleProjectExpanded(ctx.project.id);
        }

        ctx.wtState.requestRemoveWorktree(ctx.project.path, wt).catch(console.error);
        break;
      }

      // -- App --
      case "app.settings":
        useSettingsStore.getState().openSettings();
        break;

      // -- Panel creation (handled above via getCreateEventForAction early return) --
      case "panel.new.agent":
      case "panel.new.browser":
      case "panel.new.drawing":
      case "panel.new.markdown":
      case "panel.new.terminal":
      case "panel.open.localdb":
        break;

      // -- Tree-local actions (handled by focused tree widgets) --
      case "tree.collapseOrFocusParent":
      case "tree.expandOrFocusChild":
      case "tree.focusNext":
      case "tree.focusPrevious":
      case "tree.open":
      case "tree.rename":
      case "tree.toggleExpanded":
        break;

      default: {
        const _exhaustive: never = actionId;
        throw new Error(`Unknown actionId: ${String(_exhaustive)}`);
      }
    }
  }, []);
}
