/**
 * Navigate to a notification's source panel and worktree.
 *
 * Shared by the "Go to Recent Notification" keybinding and
 * click-to-navigate in the notification center overlay.
 */
import type { ServerNotification } from "@/api/notification-model";

import { getCenterApi } from "@/store/tools-bar";
import { useWorktreeStore } from "@/store/worktrees";

/** Try to activate a panel, retrying once after a short delay if not found. */
function activatePanel(panelId: string, retries = 1): void {
  const panel = getCenterApi()?.panels.find((p) => p.id === panelId);
  if (panel) {
    panel.api.setActive();
    return;
  }
  // Panel may not be mounted yet after worktree switch — retry after layout settles
  if (retries > 0) {
    setTimeout(() => activatePanel(panelId, retries - 1), 150);
  }
}

export function navigateToNotification(notification: ServerNotification): void {
  const { source } = notification;

  // Only sources with a panelId can be navigated to
  if (source.kind !== "terminal") return;
  const { panelId, worktreePath } = source;

  const wtStore = useWorktreeStore.getState();

  if (worktreePath && wtStore.activeWorktreePath !== worktreePath) {
    // Switch worktree first, then activate the panel after layout settles
    void wtStore
      .switchWorktree(worktreePath)
      .then(() => {
        requestAnimationFrame(() => activatePanel(panelId));
      })
      .catch((err) => {
        console.error("Failed to switch worktree for notification navigation", err);
      });
  } else {
    activatePanel(panelId);
  }
}
