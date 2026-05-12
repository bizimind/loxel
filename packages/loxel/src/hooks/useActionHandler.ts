/**
 * Maps ActionId -> imperative side effects via existing custom events and store actions.
 */

import type { IDockviewPanel } from "dockview-react";

import { useCallback } from "react";

import type { SplitPosition } from "@/components/dockview/default-layout";
import type { ActionId } from "@/store/keybindings/action-registry";

import { dispatchLoxelEvent } from "@/lib/loxel-events";
import { navigateToNotification } from "@/lib/notification-navigation";
import { getActiveEditorFilePath } from "@/lib/reveal-in-explorer";
import { useCommandPaletteStore } from "@/store/command-palette";
import { useFileSearchStore } from "@/store/file-search";
import { findAdjacentCenterGroup } from "@/store/layout-actions";
import { getCenterPanelDef, getCreateEventForAction } from "@/store/panel-config";
import { usePanelNotificationStore } from "@/store/panel-notifications";
import { deriveProject, useProjectStore } from "@/store/projects";
import { useSearchStore } from "@/store/search";
import { useSettingsStore } from "@/store/settings-store";
import { getCenterApi, togglePanel } from "@/store/tools-bar";
import { getOrderedWorktrees, useWorktreeStore } from "@/store/worktrees";

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

/** Resolve the active bare-repo project + its worktree state, or null if not applicable. */
function getActiveBareProject() {
  const wtState = useWorktreeStore.getState();
  const projects = useProjectStore.getState().projects;
  const project = deriveProject(wtState.activeWorktreePath, projects);
  if (!project || !(project.isBare ?? false)) return null;
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

    switch (actionId) {
      // -- Panel close --
      case "panel.close": {
        const active = getCenterApi()?.activePanel;
        if (active) active.api.close();
        break;
      }

      // -- Panel splitting (creates a new panel of the same type as the active one) --
      case "panel.split.right":
      case "panel.split.down": {
        const api = getCenterApi();
        if (!api) break;
        const active = api.activePanel;
        if (!active) break;
        const def = getCenterPanelDef(active.id);
        if (!def || def.singleton) break;
        const split: SplitPosition = {
          referencePanel: active.id,
          direction: actionId === "panel.split.right" ? "right" : "below",
        };
        const detail: Record<string, unknown> = { split };
        // For code editors, extract extension from the active editor's file path
        if (def.type === "codeEditor") {
          const filePath = active.id.slice(def.idPrefix.length);
          const dot = filePath.lastIndexOf(".");
          const slash = filePath.lastIndexOf("/");
          if (dot > slash) detail.ext = filePath.slice(dot + 1);
        }
        window.dispatchEvent(new CustomEvent(def.createEvent, { detail }));
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
        allPanels[nextIdx]?.api.setActive();
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
        if (api.panels[idx]) api.panels[idx].api.setActive();
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
        requestAnimationFrame(() => active.api.setActive());
        break;
      }

      // -- Directional focus navigation --
      case "panel.focus.right":
      case "panel.focus.left":
      case "panel.focus.up":
      case "panel.focus.down": {
        const api = getCenterApi();
        if (!api) break;
        const active = api.activePanel;
        if (!active) break;

        const direction = actionId.slice("panel.focus.".length) as "right" | "left" | "up" | "down";

        // Horizontal: try sibling tab first.
        if (direction === "right" || direction === "left") {
          const step = direction === "right" ? 1 : -1;
          const panels = active.group.panels;
          const idx = panels.indexOf(active);
          const nextIdx = idx + step;
          const sibling = idx >= 0 ? panels[nextIdx] : undefined;
          if (sibling) {
            sibling.api.setActive();
            break;
          }
        }

        // Otherwise (or for up/down): jump to adjacent group.
        const adjacent = findAdjacentCenterGroup(api, active.group, direction);
        if (adjacent) {
          const target = adjacent.activePanel ?? adjacent.panels[0];
          if (target) target.api.setActive();
        }
        break;
      }

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
        requestAnimationFrame(() => active.api.setActive());
        break;
      }

      // -- Sidebar panel toggles --
      case "toggle.projectFiles":
        togglePanel("projectFiles");
        break;
      case "toggle.changes":
        togglePanel("changes");
        break;
      case "toggle.git":
        togglePanel("git");
        break;
      case "toggle.comments":
        togglePanel("comments");
        break;
      case "toggle.logs":
        togglePanel("logs");
        break;
      case "toggle.forkTree":
        togglePanel("forkTree");
        break;

      // -- Sidebar expand/collapse (unified sidebar) --
      case "sidebar.project.toggle":
      case "sidebar.worktree.toggle":
        useProjectStore.getState().toggleSidebar();
        break;

      // -- Navigation --
      case "nav.search":
        useSearchStore.getState().open();
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

      // -- Worktree navigation --
      case "worktree.next":
      case "worktree.prev": {
        const ctx = getActiveBareProject();
        if (!ctx?.ps) break;
        const ordered = getOrderedWorktrees(ctx.ps.worktrees, ctx.ps.customOrder).filter(
          (wt) => !wt.pending,
        );
        if (ordered.length === 0) break;

        const currentIdx = ordered.findIndex((wt) => wt.path === ctx.wtState.activeWorktreePath);
        const dir = actionId === "worktree.next" ? 1 : -1;
        // When active worktree isn't in the list (e.g. pending), start from the boundary:
        // next → before first (-1+1=0), prev → after last (0-1=last)
        const safeIdx = currentIdx === -1 ? (dir === 1 ? -1 : 0) : currentIdx;
        const nextIdx = (safeIdx + dir + ordered.length) % ordered.length;
        const nextWt = ordered[nextIdx];
        if (nextWt) ctx.wtState.switchWorktree(nextWt.path);
        break;
      }

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
        const ctx = getActiveBareProject();
        if (!ctx?.ps) break;
        const ordered = getOrderedWorktrees(ctx.ps.worktrees, ctx.ps.customOrder).filter(
          (wt) => !wt.pending,
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
        const ctx = getActiveBareProject();
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
        const ctx = getActiveBareProject();
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
