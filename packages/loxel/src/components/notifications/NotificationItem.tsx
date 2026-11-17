import { XIcon } from "lucide-react";
import { useState } from "react";

import type { NotificationSource, ServerNotification } from "@/api/notification-model";
import { hostOf } from "@/components/browser/BrowserBookmarks";
import { Favicon } from "@/components/browser/Favicon";
import { NotificationSiteMenu } from "@/components/menus/NotificationSiteMenu";
import { dayjs } from "@/lib/dayjs";
import { navigateToNotification } from "@/lib/notification-navigation";
import { cn } from "@/lib/utils";
import { usePanelNotificationStore } from "@/store/panel-notifications";
import { useSettingsStore } from "@/store/settings-store";

const URGENCY_COLORS: Record<ServerNotification["urgency"], string> = {
  low: "bg-muted-foreground/40",
  // Light takes the accent blue and a deeper amber, which sit calmer on white
  normal: "bg-blue-500 not-dark:bg-button-primary",
  high: "bg-orange-500 not-dark:bg-amber-600",
  critical: "bg-red-500",
};

/** A worktree's name, or "Home" for a Home panel's notification (no worktree). */
function placeName(worktreePath: string | null): string {
  if (worktreePath === null) return "Home";
  return worktreePath.split("/").pop() || worktreePath;
}

/** Where the notification came from: the worktree or Home, and the site for a browser page. */
export function sourceLabel({ source }: ServerNotification): string {
  switch (source.kind) {
    case "server":
      return "Loxel";
    case "terminal":
      return placeName(source.worktreePath);
    case "browser":
      return `${hostOf(source.origin)} · ${placeName(source.worktreePath)}`;
    default: {
      const unknown: never = source;
      return String(unknown);
    }
  }
}

const DEFAULT_TITLES: Record<NotificationSource["kind"], string> = {
  terminal: "Terminal notification",
  browser: "Browser notification",
  server: "Loxel notification",
};

/** A collapsed site group shown through its newest notification. */
interface NotificationStack {
  /** How many notifications the group holds, this one included. */
  count: number;
  onExpand: () => void;
  onDismissAll: () => void;
}

export function NotificationItem({
  notification,
  onNavigate,
  stack,
  inGroup = false,
}: {
  notification: ServerNotification;
  onNavigate?: () => void;
  /** Show this notification as the face of its site's collapsed group. */
  stack?: NotificationStack;
  /** Listed under its expanded group's header, which already names and shows the source. */
  inGroup?: boolean;
}) {
  const title = notification.title || DEFAULT_TITLES[notification.source.kind];
  const source = sourceLabel(notification);
  // The site whose notifications the context menu mutes. Only a site the user decided for can be
  // muted: a forgotten one asks again before it notifies.
  const site = useSettingsStore((s) => {
    const { source: from } = notification;
    return from.kind === "browser" && from.origin in s.browser.notificationSites
      ? from.origin
      : null;
  });
  // Where the site menu opened; it is mounted only while open.
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
      <div
        className="hover:bg-primary/50 group flex cursor-pointer gap-2 rounded-md px-2 py-1.5"
        onClick={() => {
          navigateToNotification(notification);
          onNavigate?.();
        }}
        onContextMenu={
          site
            ? (e) => {
                e.preventDefault();
                setMenuPosition({ x: e.clientX, y: e.clientY });
              }
            : undefined
        }
      >
        {/* Urgency bar */}
        <div
          className={cn(
            "mt-1 h-4 w-0.5 shrink-0 rounded-full not-dark:my-0.5 not-dark:h-auto not-dark:w-[3px]",
            URGENCY_COLORS[notification.urgency],
          )}
        />

        {/* A browser page's site, at a glance: its favicon, or a globe without one */}
        {notification.source.kind === "browser" && !inGroup && (
          <Favicon
            url={notification.source.faviconUrl}
            pageUrl={notification.source.origin}
            className="mt-px size-3.5"
          />
        )}

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-xs font-medium">{title}</div>
          {notification.body && (
            <div className="text-muted-foreground not-dark:text-foreground/85 line-clamp-2 text-[11px] leading-tight">
              {notification.body}
            </div>
          )}
          <div className="text-muted-foreground mt-0.5 text-[10px] not-dark:text-[11px]">
            {!inGroup && <>{source} &middot; </>}
            {dayjs(notification.timestamp).fromNow()}
          </div>
        </div>

        {/* The rest of the site's notifications, behind this one */}
        {stack && (
          <button
            aria-label={`+${stack.count - 1} more from ${source}`}
            aria-expanded={false}
            title="Show all"
            className="border-border text-muted-foreground hover:text-foreground hover:bg-secondary mt-0.5 h-4 shrink-0 rounded border px-1 text-[10px] leading-[14px] font-medium tabular-nums"
            onClick={(e) => {
              e.stopPropagation();
              stack.onExpand();
            }}
          >
            +{stack.count - 1}
          </button>
        )}

        {/* Dismiss button: this one, or the whole stack */}
        <button
          aria-label={stack ? `Dismiss all ${stack.count} from ${source}` : "Dismiss"}
          title={stack ? "Dismiss all" : "Dismiss"}
          className="text-muted-foreground hover:text-foreground mt-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            if (stack) {
              stack.onDismissAll();
              return;
            }
            usePanelNotificationStore.getState().dismiss(notification.id);
          }}
        >
          <XIcon className="size-3" />
        </button>
      </div>
      {/* Outside the row: the menu's clicks bubble through React to its parent, not to the row. */}
      {site && menuPosition && (
        <NotificationSiteMenu
          origin={site}
          position={menuPosition}
          onClose={() => setMenuPosition(null)}
        />
      )}
    </>
  );
}
