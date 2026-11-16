import { ChevronUpIcon } from "lucide-react";
import { useState } from "react";

import type { ServerNotification } from "@/api/notification-model";
import { Favicon } from "@/components/browser/Favicon";
import { usePanelNotificationStore } from "@/store/panel-notifications";

import { NotificationItem, sourceLabel } from "./NotificationItem";

/**
 * A site's notifications stacked into one row that shows the newest and how many more there are.
 * Clicking the row opens the newest, like clicking it alone; the count expands the stack.
 */
export function NotificationSiteGroup({
  notifications,
  onNavigate,
}: {
  /** Two or more, newest first. */
  notifications: readonly [ServerNotification, ...ServerNotification[]];
  onNavigate?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [newest] = notifications;
  const source = sourceLabel(newest);
  // What the user sees: one that arrives as they click stays, as a new notification would.
  const dismissAll = () => {
    const { dismiss } = usePanelNotificationStore.getState();
    for (const n of notifications) dismiss(n.id);
  };

  if (!expanded) {
    return (
      <NotificationItem
        notification={newest}
        onNavigate={onNavigate}
        stack={{
          count: notifications.length,
          onExpand: () => setExpanded(true),
          onDismissAll: dismissAll,
        }}
      />
    );
  }

  return (
    <div role="group" aria-label={source}>
      <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5">
        {newest.source.kind === "browser" && (
          <Favicon url={newest.source.faviconUrl} className="size-3" />
        )}
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-[10px] font-medium not-dark:text-[11px]">
          {source} &middot; {notifications.length}
        </span>
        <button
          aria-label={`Dismiss all ${notifications.length} from ${source}`}
          className="text-muted-foreground hover:text-foreground shrink-0 text-[10px] not-dark:text-[11px]"
          onClick={dismissAll}
        >
          Dismiss all
        </button>
        <button
          aria-label={`Collapse ${source}`}
          aria-expanded
          title="Show less"
          className="text-muted-foreground hover:text-foreground shrink-0"
          onClick={() => setExpanded(false)}
        >
          <ChevronUpIcon className="size-3" />
        </button>
      </div>
      <div className="border-border not-dark:divide-border/60 ml-2 border-l not-dark:divide-y">
        {notifications.map((n) => (
          <NotificationItem key={n.id} notification={n} onNavigate={onNavigate} inGroup />
        ))}
      </div>
    </div>
  );
}
