import { XIcon } from "lucide-react";

import type { ServerNotification } from "@/api/notification-model";
import { dayjs } from "@/lib/dayjs";
import { navigateToNotification } from "@/lib/notification-navigation";
import { cn } from "@/lib/utils";
import { usePanelNotificationStore } from "@/store/panel-notifications";

const URGENCY_COLORS: Record<ServerNotification["urgency"], string> = {
  low: "bg-muted-foreground/40",
  // Light takes the accent blue and a deeper amber, which sit calmer on white
  normal: "bg-blue-500 not-dark:bg-button-primary",
  high: "bg-orange-500 not-dark:bg-amber-600",
  critical: "bg-red-500",
};

function sourceLabel(notification: ServerNotification): string {
  const { source } = notification;
  if (source.worktreePath) return source.worktreePath.split("/").pop() ?? "terminal";
  // A Home terminal's notification names no worktree.
  return "Home";
}

export function NotificationItem({
  notification,
  onNavigate,
}: {
  notification: ServerNotification;
  onNavigate?: () => void;
}) {
  const title =
    notification.title ??
    `${notification.source.kind[0]!.toUpperCase()}${notification.source.kind.slice(1)} notification`;

  return (
    <div
      className="hover:bg-primary/50 group flex cursor-pointer gap-2 rounded-md px-2 py-1.5"
      onClick={() => {
        navigateToNotification(notification);
        onNavigate?.();
      }}
    >
      {/* Urgency bar */}
      <div
        className={cn(
          "mt-1 h-4 w-0.5 shrink-0 rounded-full not-dark:my-0.5 not-dark:h-auto not-dark:w-[3px]",
          URGENCY_COLORS[notification.urgency],
        )}
      />

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-xs font-medium">{title}</div>
        {notification.body && (
          <div className="text-muted-foreground not-dark:text-foreground/85 line-clamp-2 text-[11px] leading-tight">
            {notification.body}
          </div>
        )}
        <div className="text-muted-foreground mt-0.5 text-[10px] not-dark:text-[11px]">
          {sourceLabel(notification)} &middot; {dayjs(notification.timestamp).fromNow()}
        </div>
      </div>

      {/* Dismiss button */}
      <button
        className="text-muted-foreground hover:text-foreground mt-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          usePanelNotificationStore.getState().dismiss(notification.id);
        }}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
