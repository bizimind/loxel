/**
 * Navigate to a notification's source panel and worktree.
 *
 * Shared by the "Go to Recent Notification" keybinding and
 * click-to-navigate in the notification center overlay.
 */
import { type ServerNotification, isPanelSource } from "@/api/notification-model";
import { getCenterApi } from "@/store/tools-bar";
import { useWorktreeStore } from "@/store/worktrees";

/** Try to activate a panel, retrying once after a short delay if not found. */
function activatePanelById(panelId: string, retries = 1): void {
  const api = getCenterApi();
  const panel = api?.panels.find((p) => p.id === panelId);
  if (api && panel) {
    panel.api.setActive();
    return;
  }
  // Panel may not be mounted yet after worktree switch — retry after layout settles
  if (retries > 0) {
    setTimeout(() => activatePanelById(panelId, retries - 1), 150);
  }
}

export function navigateToNotification(notification: ServerNotification): void {
  const { source } = notification;

  // Only sources with a panel can be navigated to
  if (!isPanelSource(source)) return;
  const { panelId, worktreePath } = source;

  const wtStore = useWorktreeStore.getState();

  // Like clicking a browser's notification: the page's `click` handler, or its service worker's
  // `notificationclick`, runs (to open the chat or build it was about). Main ignores refs with
  // nothing left to click: going to another worktree or Home rebuilds the layout and reloads its
  // browser panels, so only the site's service worker outlives the switch.
  const activate = () => {
    activatePanelById(panelId);
    if (source.kind === "browser") {
      window.electronAPI?.clickBrowserNotification({ ref: source.ref });
    }
  };

  if (worktreePath === null && wtStore.activeWorktreePath !== null) {
    // A Home panel's: go Home first, then activate the panel after layout settles
    wtStore.showHome();
    requestAnimationFrame(activate);
  } else if (worktreePath && wtStore.activeWorktreePath !== worktreePath) {
    // Switch worktree first, then activate the panel after layout settles
    void wtStore
      .switchWorktree(worktreePath)
      .then(() => {
        requestAnimationFrame(activate);
      })
      .catch((err) => {
        console.error("Failed to switch worktree for notification navigation", err);
      });
  } else {
    activate();
  }
}
