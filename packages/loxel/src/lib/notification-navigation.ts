/**
 * Navigate to a notification's source panel and worktree.
 *
 * Shared by the "Go to Recent Notification" keybinding and
 * click-to-navigate in the notification center overlay.
 */
import type { IDockviewPanel } from "dockview-react";

import { type PanelNotificationSource, isPanelSource } from "@/api/notification-model";
import { type WorktreeRef, sameWorktreeRef } from "@/api/worktree-ref";
import { type PageSlot, getBrowserPageSlot, whenBrowserPageAttached } from "@/store/browser-pages";
import {
  type ClientNotification,
  notificationWorktree,
  usePanelNotificationStore,
} from "@/store/panel-notifications";
import { getCenterApi } from "@/store/tools-bar";
import { useWorktreeStore } from "@/store/worktrees";

/**
 * Whether a dock panel is the notification source's: a browser source names the panel's id, a
 * terminal source the terminal's id, which its panel holds in `params.terminalId` (the id its
 * tab's notification dot goes by).
 */
function isSourcePanel(panel: IDockviewPanel, source: PanelNotificationSource): boolean {
  if (source.kind === "browser") return panel.id === source.panelId;
  const params: unknown = panel.params;
  return (
    typeof params === "object" &&
    params !== null &&
    "terminalId" in params &&
    params.terminalId === source.panelId
  );
}

/** Try to activate the source's panel, retrying once after a short delay if not found. */
function activateSourcePanel(source: PanelNotificationSource, retries = 1): void {
  const panel = getCenterApi()?.panels.find((p) => isSourcePanel(p, source));
  if (panel) {
    panel.api.setActive();
    return;
  }
  // Panel may not be mounted yet after worktree switch — retry after layout settles
  if (retries > 0) {
    setTimeout(() => activateSourcePanel(source, retries - 1), 150);
  }
}

export function navigateToNotification(notification: ClientNotification): void {
  const { source } = notification;
  const worktree = notificationWorktree(notification);

  // Panels the inbox opened: go to the worktree (or Home) they opened in, unless they opened in
  // whatever the window showed. The notification has done its job.
  if (source.kind === "inbox") {
    usePanelNotificationStore.getState().dismiss(notification);
    if (worktree !== undefined) showPlace(worktree, () => {});
    return;
  }

  // Only sources with a panel can be navigated to
  if (!isPanelSource(source) || worktree === undefined) return;
  const { panelId } = source;

  // Like clicking a browser's notification: the page's `click` handler, or its service worker's
  // `notificationclick`, runs (to open the chat or build it was about). A page in another worktree
  // or Home kept running there, so after a switch the click waits for its layout to mount, and what
  // the page opens lands next to it. Main ignores refs with nothing left to click (the page was
  // closed, unloaded or reloaded, and no service worker showed it).
  const activate = (afterSwitch: boolean) => {
    if (source.kind !== "browser") return activateSourcePanel(source);
    const click = (slot: PageSlot | null) => {
      if (slot) slot.api.setActive();
      else activateSourcePanel(source);
      window.electronAPI?.clickBrowserNotification({ ref: source.ref });
    };
    if (afterSwitch) whenBrowserPageAttached(panelId, click);
    else click(getBrowserPageSlot(panelId));
  };

  showPlace(worktree, activate);
}

/**
 * Show a worktree, or Home (null), then call `then` with whether it had to switch there, once the
 * swapped-in layout has had a frame to mount.
 */
function showPlace(worktree: WorktreeRef | null, then: (afterSwitch: boolean) => void): void {
  const wtStore = useWorktreeStore.getState();
  const active = wtStore.activeWorktree;
  if (worktree === null && active !== null) {
    wtStore.showHome();
    requestAnimationFrame(() => then(true));
  } else if (worktree && !(active && sameWorktreeRef(active, worktree))) {
    void wtStore
      .switchWorktree(worktree)
      .then(() => requestAnimationFrame(() => then(true)))
      .catch((err) => {
        console.error("Failed to switch worktree for notification navigation", err);
      });
  } else {
    then(false);
  }
}
