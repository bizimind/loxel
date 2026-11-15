import { BellIcon } from "lucide-react";
import { useCallback, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePanelNotificationStore } from "@/store/panel-notifications";

import { NotificationItem } from "./NotificationItem";

const isElectron = navigator.userAgent.includes("Electron");

export function NotificationBell() {
  const notifications = usePanelNotificationStore((s) => s.notifications);
  const hasNotifications = notifications.length > 0;
  const [open, setOpen] = useState(false);

  const closeMenu = useCallback(() => setOpen(false), []);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className="text-muted-foreground hover:text-foreground relative rounded p-1"
        style={isElectron ? { WebkitAppRegion: "no-drag" } : undefined}
      >
        <BellIcon className="size-4" />
        {hasNotifications && (
          <span className="bg-destructive absolute -top-0 right-0 size-1.5 rounded-full" />
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={4} className="w-80">
        {/* Header */}
        <div className="not-dark:border-border flex items-center justify-between px-2 py-1.5 not-dark:mb-1 not-dark:border-b not-dark:pb-2">
          <span className="text-foreground text-xs font-medium">Notifications</span>
          {hasNotifications && (
            <button
              // The popover can open with this focused; light gives it a padded button look
              // and an accent ring in place of the browser's default outline.
              className="text-muted-foreground hover:text-foreground not-dark:text-foreground not-dark:bg-muted not-dark:hover:bg-secondary not-dark:hover:text-foreground not-dark:focus-visible:ring-ring/60 text-[10px] not-dark:-my-0.5 not-dark:rounded not-dark:px-1.5 not-dark:py-0.5 not-dark:text-[11px] not-dark:outline-none not-dark:focus-visible:ring-1"
              onClick={() => usePanelNotificationStore.getState().dismissAll()}
            >
              Clear all
            </button>
          )}
        </div>

        {/* List */}
        {hasNotifications ? (
          <div className="not-dark:divide-border/60 max-h-96 overflow-y-auto not-dark:divide-y">
            {notifications.map((n) => (
              <NotificationItem key={n.id} notification={n} onNavigate={closeMenu} />
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground px-2 py-6 text-center text-xs">
            No notifications
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
