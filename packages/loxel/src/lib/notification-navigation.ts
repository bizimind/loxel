/**
 * Navigate to a notification's source panel and worktree.
 *
 * Shared by the "Go to Recent Notification" keybinding and
 * click-to-navigate in the notification center overlay.
 */
import { type ServerNotification, isPanelSource } from "@/api/notification-model";
import { type PageSlot, getBrowserPageSlot, whenBrowserPageAttached } from "@/store/browser-pages";
import { usePanelNotificationStore } from "@/store/panel-notifications";
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

  // Panels the inbox opened: go to where they opened. The notification has done its job.
  if (source.kind === "inbox") {
    usePanelNotificationStore.getState().dismiss(notification.id);
    showPlace(source.worktreePath, () => {});
    return;
  }

  // Only sources with a panel can be navigated to
  if (!isPanelSource(source)) return;
  const { panelId, worktreePath } = source;

  // Like clicking a browser's notification: the page's `click` handler, or its service worker's
  // `notificationclick`, runs (to open the chat or build it was about). A page in another worktree
  // or Home kept running there, so after a switch the click waits for its layout to mount, and what
  // the page opens lands next to it. Main ignores refs with nothing left to click (the page was
  // closed, unloaded or reloaded, a service worker that showed it is gone, or Loxel restarted since).
  const activate = (afterSwitch: boolean) => {
    if (source.kind !== "browser") return activatePanelById(panelId);
    const click = (slot: PageSlot | null) => {
      if (slot) slot.api.setActive();
      else activatePanelById(panelId);
      window.electronAPI?.clickBrowserNotification({ ref: source.ref });
    };
    if (afterSwitch) whenBrowserPageAttached(panelId, click);
    else click(getBrowserPageSlot(panelId));
  };

  showPlace(worktreePath, activate);
}

/**
 * Show a worktree, or Home (null), then call `then` with whether it had to switch there, once the
 * swapped-in layout has had a frame to mount.
 */
function showPlace(worktreePath: string | null, then: (afterSwitch: boolean) => void): void {
  const wtStore = useWorktreeStore.getState();
  if (worktreePath === null && wtStore.activeWorktreePath !== null) {
    wtStore.showHome();
    requestAnimationFrame(() => then(true));
  } else if (worktreePath && wtStore.activeWorktreePath !== worktreePath) {
    void wtStore
      .switchWorktree(worktreePath)
      .then(() => requestAnimationFrame(() => then(true)))
      .catch((err) => {
        console.error("Failed to switch worktree for notification navigation", err);
      });
  } else {
    then(false);
  }
}
