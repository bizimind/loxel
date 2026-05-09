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
        style={isElectron ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined}
      >
        <BellIcon className="size-3.5" />
        {hasNotifications && (
          <span className="bg-destructive absolute -top-0 right-0 size-1.5 rounded-full" />
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={4} className="w-80">
        {/* Header */}
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-foreground text-xs font-medium">Notifications</span>
          {hasNotifications && (
            <button
              className="text-muted-foreground hover:text-foreground text-[10px]"
              onClick={() => usePanelNotificationStore.getState().dismissAll()}
            >
              Clear all
            </button>
          )}
        </div>

        {/* List */}
        {hasNotifications ? (
          <div className="max-h-96 overflow-y-auto">
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
